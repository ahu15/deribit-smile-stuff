from math import sqrt, pi, log, e
import scipy
from scipy.interpolate import interp1d
from scipy.optimize import toms748
from scipy.stats import norm
import numpy as np

class SABR:
    def lognormal_vol(k, f, t, alpha, beta, rho, volvol):
        """
        Hagan's 2002 SABR lognormal vol expansion.
        The strike k can be a scalar or an array
        """
        # Negative strikes or forwards
        # if k <= 0 or f <= 0:
        #     return 0.
        eps = 1e-07
        logfk = np.log(f / k)
        fkbeta = (f * k) ** (1 - beta)
        a = (1 - beta) ** 2 * alpha ** 2 / (24 * fkbeta)
        b = 0.25 * rho * beta * volvol * alpha / fkbeta ** 0.5
        c = (2 - 3 * rho ** 2) * volvol ** 2 / 24
        d = fkbeta ** 0.5
        v = (1 - beta) ** 2 * logfk ** 2 / 24
        w = (1 - beta) ** 4 * logfk ** 4 / 1920
        z = volvol * fkbeta ** 0.5 * logfk / alpha

        # if |z| > eps
        try:
            iterator=iter(z)
        except:
            if abs(z) > eps:
                vz = alpha * z * (1 + (a + b + c) * t) / (d * (1 + v + w) * SABR._x(rho, z))
                return vz
            # if |z| <= eps
            else:
                v0 = alpha * (1 + (a + b + c) * t) / (d * (1 + v + w))
                return v0
        else:
            vz = alpha * z * (1 + (a + b + c) * t) / (d * (1 + v + w) * SABR._x(rho, z))
            v0 = alpha * (1 + (a + b + c) * t) / (d * (1 + v + w))
            if any(np.isnan(vz)) == True:
                vz[np.isnan(vz)] = v0[0]
            return vz
            # try:
            #     vz[np.isnan(vz)] = v0[0]
            # except:
            #     return vz
            # else:
            #     vz[np.isnan(vz)] = v0[0]
            # return vz

    def _x(rho, z):
        a = (1 - 2 * rho * z + z ** 2) ** .5 + z - rho
        b = 1 - rho
        return np.log(a / b)

    def SABRfit(K,F,T_y,sigma,beta=1,
                p0=[0.75, -0.1 , 2.5],bounds=([0.3,-1,1],[2,1,10]),
                error=0, absolute_sigma=False):

        def SABRvol(K,alpha,rho,volvol):
            return SABR.lognormal_vol(k=K, f=F, t=T_y, alpha=alpha, beta=beta, rho=rho, volvol=volvol)

        if isinstance(error, int):
            popt, pcov = scipy.optimize.curve_fit(f=SABRvol,xdata=K,ydata=sigma,p0=p0,bounds=bounds)
        else:
            popt, pcov = scipy.optimize.curve_fit(f=SABRvol, xdata=K, ydata=sigma, p0=p0, bounds=bounds, sigma=error, absolute_sigma=absolute_sigma)

        alpha=popt[0]
        rho=popt[1]
        volvol=popt[2]

        return [alpha,rho,volvol]

    ### built by Leo ###
    def SABRdelta(k, f, t, CP, alpha, beta, rho, volvol, f_step = 0.005, f_rate = None):
        #Change in forward
        f_down = f * (1 - f_step)
        f_up = f * (1 + f_step)

        #Change in vol
        vol_down = SABR.lognormal_vol(k, f_down, t, alpha, beta, rho, volvol)
        vol_up = SABR.lognormal_vol(k, f_up, t, alpha, beta, rho, volvol)

        #Change in premium
        prem_down = BSMerton(CallPut=CP, S = f_down, K=k, r = 0, q = 0, T_days = t * 365, sigma = vol_down).premium()
        prem_up = BSMerton(CallPut=CP, S=f_up, K=k, r=0, q=0, T_days=t * 365, sigma=vol_up).premium()

        #Delta
        delta = (prem_up - prem_down) / (f_up - f_down)

        if f_rate:
            delta *= np.e**(f_rate*t)

        return delta
    
    ### funky evaluation USE WITH CAUTION ###
    def SABRgamma(k, f, t, CP, alpha, beta, rho, volvol, f_step = 0.0005):
        #Change in forward
        f_down = f * (1 - f_step)
        f_up = f * (1 + f_step)

        #Change in delta
        d_down = SABR.SABRdelta(k, f_down, t, CP, alpha, beta, rho, volvol)
        d_up = SABR.SABRdelta(k, f_up, t, CP, alpha, beta, rho, volvol)
        
        #Gamma
        gamma = (d_up - d_down) / (f_up - f_down)

        return gamma
    
    def SABRtheta(k, f, t, CP, alpha, beta, rho, volvol, t_step = -1):
        t_adj = max(t + t_step/365, 0.00001)

        #Change in vol
        vol_now = SABR.lognormal_vol(k, f, t, alpha, beta, rho, volvol)
        vol_adj = SABR.lognormal_vol(k, f, t_adj, alpha, beta, rho, volvol)

        #Change in premium
        prem = BSMerton(CallPut=CP, S = f, K=k, r = 0, q = 0, T_days = t * 365, sigma = vol_now).premium()
        prem_adj = BSMerton(CallPut=CP, S=f, K=k, r=0, q=0, T_days=t_adj * 365, sigma=vol_adj).premium()

        #Theta
        theta = (prem_adj - prem) / t_step 

        return theta
    
    def SABRvega(k, f, t, CP, alpha, beta, rho, volvol, v_step = 0.005):
        #Change in forward
        v = SABR.lognormal_vol(k, f, t, alpha, beta, rho, volvol)
        vol_down = max(0.01, v - v_step) #edge case 1v
        vol_up = v + v_step

        #Change in premium
        prem_down = BSMerton(CallPut=CP, S = f, K=k, r = 0, q = 0, T_days = t * 365, sigma = vol_down).premium()
        prem_up = BSMerton(CallPut=CP, S = f, K=k, r = 0, q = 0, T_days = t * 365, sigma = vol_up).premium()

        #Vanna
        vanna = (prem_up - prem_down) / (2 * v_step * 100)

        return vanna
    
    #vanna as in change in delta per change in vol (BS vanna?)
    def SABRvanna(k, f, t, CP, alpha, beta, rho, volvol, v_step = 0.005):
        #Change in forward
        v = SABR.lognormal_vol(k, f, t, alpha, beta, rho, volvol)
        vol_down = max(0.01, v - v_step) #edge case 1v
        vol_up = v + v_step

        #Change in delta
        d_down = BSMerton(CallPut=CP, S = f, K=k, r = 0, q = 0, T_days = t * 365, sigma = vol_down).delta()
        d_up = BSMerton(CallPut=CP, S = f, K=k, r = 0, q = 0, T_days = t * 365, sigma = vol_up).delta()

        #Vanna
        vanna = (d_up - d_down) / (2 * v_step * 100)

        return vanna

class BSMerton:
    def __init__(self, CallPut, S, K, r, q, T_days, **sigmaprem):
        """
        :param CallPut:
        :param S:
        :param K:
        :param r:
        :param q:
        :param T: expiry time IN DAYS
        :param sigmaprem:
        """
        self.Type = int(CallPut)  # 1 for a Call, - 1 for a put
        self.S = float(S)  # Underlying asset price
        self.K = float(K)  # Option strike K
        self.r = float(r)  # Continuous risk fee rate
        self.q = float(q)  # Dividend continuous rate
        self.T = float(T_days) / 365.0  # Compute time to expiry
        if 'IVguess' in sigmaprem:self.IV_guess = float(sigmaprem['IVguess'])
        if 'sigma' in sigmaprem:
            self.sigma = float(sigmaprem['sigma']) # Underlying volatility
        elif 'IVguess' in sigmaprem:
            self.sigma = self.IV_guess # Underlying volatility
        else:
            self.sigma=0.75
        self.sigmaT = self.sigma * self.T ** 0.5  # sigma*T for reusability
        self.d1 = (log(self.S / self.K) + \
                   (self.r - self.q + 0.5 * (self.sigma ** 2)) \
                   * self.T) / self.sigmaT
        self.d2 = self.d1 - self.sigmaT
        if 'prem' in sigmaprem: self.prem=float(sigmaprem['prem'])
        if 'tol' in sigmaprem: self.tol = float(sigmaprem['tol'])
        if 'max_iter' in sigmaprem: self.max_iter = int(sigmaprem['max_iter'])

        # [self.Premium] = self.premium()
        # [self.Delta] = self.delta()
        # [self.Theta] = self.theta()
        # [self.Rho] = self.rho()
        # [self.Vega] = self.vega()
        # [self.Gamma] = self.gamma()
        # [self.Phi] = self.phi()
        # [self.Charm] = self.dDeltadTime()
        # [self.Vanna] = self.dDeltadVol()
        # [self.IV] = self.IV()

    def premium(self):
        tmpprem = self.Type * (self.S * e ** (-self.q * self.T) * norm.cdf(self.Type * self.d1) - \
                               self.K * e ** (-self.r * self.T) * norm.cdf(self.Type * self.d2))
        return tmpprem

    ############################################
    ############ 1st order greeks ##############
    ############################################

    def delta(self):
        dfq = e ** (-self.q * self.T)
        if self.Type == 1:
            return dfq * norm.cdf(self.d1)
        else:
            return dfq * (norm.cdf(self.d1) - 1)

    # Vega for 1% change in vol
    def vega(self):
        return 0.01 * self.S * e ** (-self.q * self.T) * \
                norm.pdf(self.d1) * self.T ** 0.5

    def volga(self):
        return e ** (-self.q * self.T) * (self.T**0.5) * norm.pdf(self.d1) * (self.d1 * self.d2) / self.sigma

    # Theta for 1 day change
    def theta(self):
        df = e ** -(self.r * self.T)
        dfq = e ** (-self.q * self.T)
        tmptheta = (1.0 / 365.0) \
                   * (-0.5 * self.S * dfq * norm.pdf(self.d1) * \
                      self.sigma / (self.T ** 0.5) + \
                      self.Type * (self.q * self.S * dfq * norm.cdf(self.Type * self.d1) \
                                   - self.r * self.K * df * norm.cdf(self.Type * self.d2)))
        return tmptheta

    def rho(self):
        df = e ** -(self.r * self.T)
        return self.Type * self.K * self.T * df * 0.01 * norm.cdf(self.Type * self.d2)

    def phi(self):
        return 0.01 * -self.Type * self.T * self.S * \
                e ** (-self.q * self.T) * norm.cdf(self.Type * self.d1)

    ############################################
    ############ 2nd order greeks ##############
    ############################################

    def gamma(self):
        return e ** (-self.q * self.T) * norm.pdf(self.d1) / (self.S * self.sigmaT)

    # Charm for 1 day change
    def dDeltadTime(self):
        dfq = e ** (-self.q * self.T)
        if self.Type == 1:
            return (1.0 / 365.0) * -dfq * (norm.pdf(self.d1) * ((self.r - self.q) / (self.sigmaT) - self.d2 / (2 * self.T)) \
                                        + (-self.q) * norm.cdf(self.d1))
        else:
            return (1.0 / 365.0) * -dfq * (norm.pdf(self.d1) * ((self.r - self.q) / (self.sigmaT) - self.d2 / (2 * self.T)) \
                                        + self.q * norm.cdf(-self.d1))

    # Vanna for 1% change in vol
    def dDeltadVol(self):
        return 0.01 * -e ** (-self.q * self.T) * self.d2 / self.sigma * norm.pdf(self.d1)

    # Vomma
    def dVegadVol(self):
        return 0.01 * -e ** (-self.q * self.T) * self.d2 / self.sigma * norm.pdf(self.d1)

    #Implied Vol
    def IV(self):
        vega=self.vega()
        sigma=self.sigma
        volga=self.volga()
        for i in range(self.max_iter):

            ### calculate difference between blackscholes price and market price with
            ### iteratively updated volality estimate
            diff = self.premium() - self.prem

            ###break if difference is less than specified tolerance level
            if abs(diff) < self.tol:
                # print(f'found on {i}th iteration')
                # print(f'difference is equal to {diff}')
                break

            ### use newton rapshon to update the estimate
            a = -0.5 * self.volga()
            b = self.vega()
            c = -diff
            D_sigma = (-b + (b**2 - 4*a*c)**0.5)/(2*a)


            self.sigma = self.sigma - (D_sigma/100)
            self.sigmaT = self.sigma * self.T ** 0.5
            self.d1 = (log(self.S / self.K) + \
                       (self.r - self.q + 0.5 * (self.sigma ** 2)) \
                       * self.T) / self.sigmaT
            self.d2 = self.d1 - self.sigmaT

        return self.sigma